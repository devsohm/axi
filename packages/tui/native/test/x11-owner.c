#include <xcb/xcb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static xcb_atom_t intern(xcb_connection_t *connection, const char *name) {
    xcb_intern_atom_reply_t *reply = xcb_intern_atom_reply(connection,
        xcb_intern_atom(connection, 0, strlen(name), name), NULL);
    if (!reply) exit(2);
    xcb_atom_t atom = reply->atom;
    free(reply);
    return atom;
}

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    xcb_connection_t *connection = xcb_connect(NULL, NULL);
    if (xcb_connection_has_error(connection)) return 2;
    xcb_screen_t *screen = xcb_setup_roots_iterator(xcb_get_setup(connection)).data;
    xcb_window_t window = xcb_generate_id(connection);
    xcb_create_window(connection, XCB_COPY_FROM_PARENT, window, screen->root,
        0, 0, 1, 1, 0, XCB_WINDOW_CLASS_INPUT_OUTPUT, XCB_COPY_FROM_PARENT, 0, NULL);
    xcb_atom_t clipboard = intern(connection, "CLIPBOARD");
    xcb_atom_t targets = intern(connection, "TARGETS");
    xcb_atom_t text = intern(connection, "UTF8_STRING");
    xcb_atom_t png = intern(connection, "image/png");
    xcb_atom_t incremental = intern(connection, "INCR");
    xcb_set_selection_owner(connection, window, clipboard, XCB_CURRENT_TIME);
    xcb_get_selection_owner_reply_t *owner = xcb_get_selection_owner_reply(connection,
        xcb_get_selection_owner(connection, clipboard), NULL);
    if (!owner || owner->owner != window) return 2;
    free(owner);
    puts("ready");
    fflush(stdout);

    xcb_window_t receiver = XCB_NONE;
    xcb_atom_t property = XCB_NONE, target = XCB_NONE;
    unsigned chunk = 0;
    xcb_generic_event_t *event;
    while ((event = xcb_wait_for_event(connection))) {
        switch (event->response_type & 127) {
            case XCB_SELECTION_REQUEST: {
                xcb_selection_request_event_t *request = (void *)event;
                xcb_atom_t destination = request->property;
                if (request->target == targets) {
                    if (strcmp(argv[1], "fallback") == 0) destination = XCB_NONE;
                    else {
                        xcb_atom_t formats[] = {text, png};
                        xcb_change_property(connection, XCB_PROP_MODE_REPLACE, request->requestor,
                            destination, XCB_ATOM_ATOM, 32, 2, formats);
                    }
                } else if (strcmp(argv[1], "fallback") == 0) {
                    const char value[] = "fallback \xe6\x96\x87\xe5\xad\x97";
                    xcb_change_property(connection, XCB_PROP_MODE_REPLACE, request->requestor,
                        destination, text, 8, sizeof(value) - 1, value);
                } else {
                    receiver = request->requestor;
                    property = destination;
                    target = request->target;
                    chunk = 0;
                    uint32_t mask = XCB_EVENT_MASK_PROPERTY_CHANGE, length = 4;
                    xcb_change_window_attributes(connection, receiver, XCB_CW_EVENT_MASK, &mask);
                    xcb_change_property(connection, XCB_PROP_MODE_REPLACE, receiver,
                        property, incremental, 32, 1, &length);
                }
                union { xcb_selection_notify_event_t selection; char bytes[32]; } response = { .selection = {
                    .response_type = XCB_SELECTION_NOTIFY, .time = request->time,
                    .requestor = request->requestor, .selection = request->selection,
                    .target = request->target, .property = destination,
                } };
                xcb_send_event(connection, 0, request->requestor, 0, response.bytes);
                break;
            }
            case XCB_PROPERTY_NOTIFY: {
                xcb_property_notify_event_t *notice = (void *)event;
                if (notice->window != receiver || notice->atom != property || notice->state != XCB_PROPERTY_DELETE) break;
                if (chunk++ == 0) {
                    const char bytes[] = "part";
                    xcb_change_property(connection, XCB_PROP_MODE_REPLACE, receiver, property, target, 8, 4, bytes);
                } else if (strcmp(argv[1], "mismatch") == 0) {
                    // The empty terminator must retain the preceding chunk's type and format.
                    xcb_change_property(connection, XCB_PROP_MODE_REPLACE, receiver, property, XCB_ATOM_ATOM, 32, 0, NULL);
                }
                break;
            }
        }
        free(event);
        xcb_flush(connection);
    }
    xcb_disconnect(connection);
    return 0;
}
