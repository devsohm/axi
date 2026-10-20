#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include "../../clipboard.h"

static void platform_clipboard(ClipboardRequest *request) {
    @autoreleasepool {
        NSPasteboard *board = [NSPasteboard generalPasteboard];
        if (!board) { request->error = "Could not open clipboard"; return; }
        switch (request->operation) {
            case WRITE_TEXT: {
                NSString *text = [[NSString alloc] initWithBytes:request->data length:request->length encoding:NSUTF8StringEncoding];
                if (!text) { request->error = "Clipboard text is not valid UTF-8"; break; }
                [board clearContents];
                if (![board setString:text forType:NSPasteboardTypeString]) request->error = "Could not set clipboard text";
                break;
            }
            case READ_TEXT: {
                NSString *text = [board stringForType:NSPasteboardTypeString];
                if (!text) request->encoding = EMPTY;
                else if (!text.UTF8String) request->error = "Could not encode clipboard text";
                else save_bytes(request, text.UTF8String, [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding], UTF8);
                break;
            }
            case READ_IMAGE: {
                if (![board availableTypeFromArray:@[NSPasteboardTypePNG, NSPasteboardTypeTIFF]]) {
                    request->encoding = EMPTY; break;
                }
                NSData *bytes = [board dataForType:NSPasteboardTypePNG];
                if (!bytes) {
                    NSImage *image = [[NSImage alloc] initWithPasteboard:board];
                    NSData *tiff = image.TIFFRepresentation;
                    NSBitmapImageRep *bitmap = tiff ? [NSBitmapImageRep imageRepWithData:tiff] : nil;
                    bytes = bitmap ? [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] : nil;
                }
                if (bytes) save_bytes(request, bytes.bytes, bytes.length, BINARY);
                else request->error = "Clipboard does not contain an image";
                break;
            }
            case READ_FILES: {
                NSArray *urls = [board readObjectsForClasses:@[[NSURL class]] options:@{NSPasteboardURLReadingFileURLsOnlyKey:@YES}];
                size_t total = 0;
                for (NSURL *url in urls) {
                    const char *path = url.fileSystemRepresentation;
                    if (!path) continue;
                    size_t size = strlen(path);
                    if (size == SIZE_MAX || total > SIZE_MAX - size - 1) { request->error = "Clipboard file paths are too large"; return; }
                    total += size + 1;
                }
                if (!total) { request->encoding = EMPTY; break; }
                request->data = malloc(total);
                if (!request->data) { request->error = "Out of memory"; break; }
                char *cursor = request->data;
                for (NSURL *url in urls) {
                    const char *path = url.fileSystemRepresentation;
                    if (!path) continue;
                    size_t size = strlen(path) + 1;
                    memcpy(cursor, path, size); cursor += size;
                }
                request->encoding = PATHS; request->length = total;
                break;
            }
        }
    }
}
static napi_value modifier(napi_env env, napi_callback_info info) {
    size_t count = 1, length;
    napi_value argument, value;
    char name[16] = {0};
    CGEventFlags mask = 0;
    napi_get_cb_info(env, info, &count, &argument, NULL, NULL);
    if (count && napi_get_value_string_utf8(env, argument, name, sizeof(name), &length) == napi_ok) {
        if (!strcmp(name, "shift")) mask = kCGEventFlagMaskShift;
        else if (!strcmp(name, "control")) mask = kCGEventFlagMaskControl;
        else if (!strcmp(name, "command")) mask = kCGEventFlagMaskCommand;
        else if (!strcmp(name, "option")) mask = kCGEventFlagMaskAlternate;
    }
    napi_get_boolean(env, mask && (CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState) & mask), &value);
    return value;
}
NAPI_MODULE_INIT() {
    export_clipboard(env, exports, 4);
    napi_property_descriptor method = {"isModifierPressed", NULL, modifier, NULL, NULL, NULL, napi_default, NULL};
    napi_define_properties(env, exports, 1, &method);
    return exports;
}
