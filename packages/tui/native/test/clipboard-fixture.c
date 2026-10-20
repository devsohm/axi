#include "../clipboard.h"
static void platform_clipboard(ClipboardRequest *request) {
    switch (request->operation) {
        case READ_TEXT: save_bytes(request, "caf\xc3\xa9", 5, UTF8); break;
        case READ_IMAGE: { unsigned char bytes[] = {0, 127, 255}; save_bytes(request, bytes, 3, BINARY); break; }
        case WRITE_TEXT:
#ifdef _WIN32
            { const uint16_t text[] = {99, 97, 102, 233};
              if (request->length != 4 || memcmp(request->data, text, sizeof(text))) request->error = "Unexpected text"; }
#else
            if (request->length != 5 || memcmp(request->data, "caf\xc3\xa9", 5)) request->error = "Unexpected text";
#endif
            break;
        case READ_FILES: save_bytes(request, "/one\0/two\0", 10, PATHS); break;
    }
}
NAPI_MODULE_INIT() { export_clipboard(env, exports, 4); return exports; }
