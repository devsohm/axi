#define _POSIX_C_SOURCE 200809L
#include "../../clipboard.h"
#include <xcb/xcb.h>
#include <xcb/xcbext.h>
#include <pthread.h>
#include <poll.h>
#include <errno.h>
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define BYTE_LIMIT (50u * 1024u * 1024u)
typedef struct { unsigned char *bytes; size_t size; uint32_t count; uint8_t format; xcb_atom_t type; } Payload;
typedef struct {
    xcb_connection_t *connection;
    xcb_window_t window;
    xcb_atom_t selection, property, targets, incremental;
    int64_t deadline;
} Reader;
typedef struct { Payload payload; bool image, available; const char *error; } Result;
static int64_t milliseconds(void) {
    struct timespec value;
    clock_gettime(CLOCK_MONOTONIC, &value);
    return (int64_t)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}
static bool await_socket(Reader *reader) {
    for (;;) {
        int64_t left = reader->deadline - milliseconds();
        if (left <= 0 || xcb_connection_has_error(reader->connection)) return false;
        struct pollfd socket = { .fd = xcb_get_file_descriptor(reader->connection), .events = POLLIN };
        int ready = poll(&socket, 1, (int)left);
        if (ready >= 0) return ready > 0 && (socket.revents & POLLIN);
        if (errno != EINTR) return false;
    }
}
static void *reply(Reader *reader, unsigned sequence) {
    if (xcb_flush(reader->connection) > 0) {
        do {
            void *value = NULL;
            xcb_generic_error_t *error = NULL;
            int ready = xcb_poll_for_reply(reader->connection, sequence, &value, &error);
            free(error);
            if (ready) return value;
        } while (await_socket(reader));
    }
    xcb_discard_reply(reader->connection, sequence);
    return NULL;
}
static xcb_generic_event_t *event(Reader *reader, uint8_t kind) {
    if (xcb_flush(reader->connection) <= 0) return NULL;
    while (milliseconds() < reader->deadline) {
        xcb_generic_event_t *value = xcb_poll_for_event(reader->connection);
        if (!value) { if (!await_socket(reader)) break; continue; }
        if ((value->response_type & 127) == kind) return value;
        free(value);
    }
    return NULL;
}
static bool append(Payload *value, const void *bytes, size_t size) {
    if (size > BYTE_LIMIT - value->size) return false;
    unsigned char *next = realloc(value->bytes, value->size + size + 1);
    if (!next) return false;
    if (size) memcpy(next + value->size, bytes, size);
    value->size += size;
    next[value->size] = 0;
    value->bytes = next;
    return true;
}
static bool property(Reader *reader, bool remove, Payload *value) {
    unsigned sequence = xcb_get_property(reader->connection, remove, reader->window,
        reader->property, XCB_GET_PROPERTY_TYPE_ANY, 0, BYTE_LIMIT / 4).sequence;
    xcb_get_property_reply_t *data = reply(reader, sequence);
    if (!data) return false;
    uint64_t size = (uint64_t)data->value_len * (data->format / 8);
    bool valid = (data->format == 8 || data->format == 16 || data->format == 32) &&
        data->type && !data->bytes_after && size <= BYTE_LIMIT && size <= (uint64_t)data->length * 4;
    if (valid) {
        value->type = data->type;
        value->format = data->format;
        value->count = data->value_len;
        valid = append(value, xcb_get_property_value(data), (size_t)size);
    }
    free(data);
    return valid;
}
static bool selection(Reader *reader, xcb_atom_t target, Payload *value) {
    xcb_delete_property(reader->connection, reader->window, reader->property);
    xcb_convert_selection(reader->connection, reader->window, reader->selection,
        target, reader->property, XCB_CURRENT_TIME);
    for (;;) {
        xcb_selection_notify_event_t *notice = (void *)event(reader, XCB_SELECTION_NOTIFY);
        if (!notice) return false;
        bool relevant = notice->selection == reader->selection && notice->target == target;
        bool offered = notice->property != XCB_NONE;
        free(notice);
        if (!relevant) continue;
        if (!offered) return true;
        if (!property(reader, false, value)) return false;
        break;
    }
    if (value->type != reader->incremental) return true;
    free(value->bytes);
    memset(value, 0, sizeof(*value));
    xcb_delete_property(reader->connection, reader->window, reader->property);
    for (;;) {
        xcb_property_notify_event_t *notice = (void *)event(reader, XCB_PROPERTY_NOTIFY);
        if (!notice) return false;
        bool relevant = notice->atom == reader->property && notice->state == XCB_PROPERTY_NEW_VALUE;
        free(notice);
        if (!relevant) continue;
        Payload part = {0};
        bool valid = property(reader, true, &part);
        valid = valid && part.type && (part.format == 8 || part.format == 16 || part.format == 32) &&
            (uint64_t)part.count * (part.format / 8) == part.size &&
            (!value->type || (value->type == part.type && value->format == part.format)) &&
            part.count <= UINT32_MAX - value->count;
        if (valid) valid = append(value, part.bytes, part.size);
        if (valid) { value->type = part.type; value->format = part.format; value->count += part.count; }
        bool done = part.count == 0;
        free(part.bytes);
        if (!valid) return false;
        if (done) return true;
    }
}
static xcb_atom_t atom(Reader *reader, const char *name) {
    xcb_intern_atom_reply_t *value = reply(reader,
        xcb_intern_atom(reader->connection, false, strlen(name), name).sequence);
    xcb_atom_t id = value ? value->atom : XCB_NONE;
    free(value);
    return id;
}
static bool open_reader(Reader *reader) {
    reader->deadline = milliseconds() + 2000;
    int index = 0;
    reader->connection = xcb_connect(NULL, &index);
    if (xcb_connection_has_error(reader->connection)) return false;
    xcb_screen_iterator_t screen = xcb_setup_roots_iterator(xcb_get_setup(reader->connection));
    while (index-- > 0 && screen.rem) xcb_screen_next(&screen);
    if (!screen.rem) return false;
    reader->window = xcb_generate_id(reader->connection);
    uint32_t mask = XCB_EVENT_MASK_PROPERTY_CHANGE;
    xcb_create_window(reader->connection, XCB_COPY_FROM_PARENT, reader->window, screen.data->root,
        0, 0, 1, 1, 0, XCB_WINDOW_CLASS_INPUT_OUTPUT, XCB_COPY_FROM_PARENT, XCB_CW_EVENT_MASK, &mask);
    reader->selection = atom(reader, "CLIPBOARD");
    reader->property = atom(reader, "AXI_CLIPBOARD");
    reader->targets = atom(reader, "TARGETS");
    reader->incremental = atom(reader, "INCR");
    return reader->selection && reader->property && reader->targets && reader->incremental;
}
static bool read_target(Reader *reader, Result *result) {
    static const char *text[] = {"text/plain;charset=utf-8", "text/plain;charset=UTF-8", "UTF8_STRING", "text/plain", "STRING"};
    static const char *image[] = {"image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/tiff"};
    xcb_atom_t preferred[6], target = XCB_NONE;
    size_t count = result->image ? 6 : 5;
    for (size_t i = 0; i < count; i++) {
        preferred[i] = atom(reader, result->image ? image[i] : text[i]);
        if (!preferred[i]) return false;
    }
    Payload offered = {0};
    bool valid = selection(reader, reader->targets, &offered);
    bool typed = offered.type == XCB_ATOM_ATOM && offered.format == 32 &&
        offered.size % sizeof(xcb_atom_t) == 0 && offered.count == offered.size / sizeof(xcb_atom_t);
    if (valid && typed) {
        const xcb_atom_t *ids = (const void *)offered.bytes;
        for (size_t i = 0; !target && i < count; i++)
            for (uint32_t j = 0; j < offered.count; j++)
                if (ids[j] == preferred[i]) { target = ids[j]; break; }
    } else if (valid && !offered.type && !result->image) target = preferred[2];
    valid = valid && (typed || !offered.type);
    free(offered.bytes);
    return valid && (!target || selection(reader, target, &result->payload));
}
static void read_result(Result *result) {
    Reader reader = {0};
    if (open_reader(&reader)) {
        result->available = true;
        if (!read_target(&reader, result)) {
            free(result->payload.bytes);
            memset(&result->payload, 0, sizeof(result->payload));
            result->error = "Could not read X11 clipboard";
        }
    }
    if (reader.connection) xcb_disconnect(reader.connection);
}

typedef struct { Result result; bool finished, abandoned; } Transfer;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed;
static pthread_once_t initialized = PTHREAD_ONCE_INIT;
static bool ready;
static int (*notify)(pthread_cond_t *);
static int (*wait_until)(pthread_cond_t *, pthread_mutex_t *, const struct timespec *);
static void initialize(void) {
    int (*create)(pthread_cond_t *, const pthread_condattr_t *) = dlsym(RTLD_DEFAULT, "pthread_cond_init");
    notify = dlsym(RTLD_DEFAULT, "pthread_cond_signal");
    wait_until = dlsym(RTLD_DEFAULT, "pthread_cond_timedwait");
    if (!create || !notify || !wait_until) return;
    pthread_condattr_t attributes;
    if (pthread_condattr_init(&attributes) != 0) return;
    ready = pthread_condattr_setclock(&attributes, CLOCK_MONOTONIC) == 0 &&
        create(&changed, &attributes) == 0;
    pthread_condattr_destroy(&attributes);
}
static bool busy;
static void *transfer(void *data) {
    Transfer *value = data;
    read_result(&value->result);
    pthread_mutex_lock(&lock);
    value->finished = true;
    if (value->abandoned) { free(value->result.payload.bytes); free(value); busy = false; }
    notify(&changed);
    pthread_mutex_unlock(&lock);
    return NULL;
}
static void platform_clipboard(ClipboardRequest *request) {
    pthread_once(&initialized, initialize);
    if (!ready) return;
    Result result = { .image = request->operation == READ_IMAGE };
    pthread_mutex_lock(&lock);
    if (!busy) {
        Transfer *value = calloc(1, sizeof(*value));
        if (value) {
            value->result.image = result.image;
            pthread_t thread;
            busy = true;
            if (pthread_create(&thread, NULL, transfer, value) == 0) {
                pthread_detach(thread);
                struct timespec deadline;
                clock_gettime(CLOCK_MONOTONIC, &deadline);
                deadline.tv_sec += 3;
                while (!value->finished && wait_until(&changed, &lock, &deadline) == 0) {}
                if (value->finished) { result = value->result; free(value); busy = false; }
                else value->abandoned = true;
            } else { free(value); busy = false; }
        }
    }
    pthread_mutex_unlock(&lock);
    request->data = result.payload.bytes;
    request->length = result.payload.size;
    request->error = result.error;
    request->encoding = !result.available ? UNAVAILABLE : !result.payload.bytes ? EMPTY :
        result.image ? BINARY : result.payload.type == XCB_ATOM_STRING ? LATIN1 : UTF8;
}
NAPI_MODULE_INIT() {
    export_clipboard(env, exports, 2);
    return exports;
}
