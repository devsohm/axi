#ifndef AXI_CLIPBOARD_H
#define AXI_CLIPBOARD_H
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef enum { READ_TEXT, READ_IMAGE, WRITE_TEXT, READ_FILES } Operation;
typedef enum { UNAVAILABLE, EMPTY, UTF8, LATIN1, UTF16, BINARY, PATHS } Encoding;
typedef struct {
    napi_async_work work;
    napi_deferred deferred;
    Operation operation;
    Encoding encoding;
    void *data;
    size_t length;
    const char *error;
} ClipboardRequest;
static void platform_clipboard(ClipboardRequest *request);
static inline void save_bytes(ClipboardRequest *request, const void *bytes, size_t size, Encoding encoding) {
    void *data = malloc(size ? size : 1);
    if (!data) { request->error = "Out of memory"; return; }
    if (size) memcpy(data, bytes, size);
    request->data = data;
    request->length = encoding == UTF16 ? size / sizeof(uint16_t) : size;
    request->encoding = encoding;
}
static void run_clipboard(napi_env env, void *data) { (void)env; platform_clipboard(data); }
static void settle_clipboard(napi_env env, napi_status status, void *data) {
    ClipboardRequest *request = data;
    napi_value result;
    napi_get_undefined(env, &result);
    if (status != napi_ok) request->error = "Clipboard operation cancelled";
    if (!request->error && request->operation != WRITE_TEXT) {
        switch (request->encoding) {
            case UNAVAILABLE: break;
            case EMPTY: status = napi_get_null(env, &result); break;
            case UTF8: status = napi_create_string_utf8(env, request->data, request->length, &result); break;
            case LATIN1: status = napi_create_string_latin1(env, request->data, request->length, &result); break;
            case UTF16: status = napi_create_string_utf16(env, request->data, request->length, &result); break;
            case BINARY: status = napi_create_buffer_copy(env, request->length, request->data, NULL, &result); break;
            case PATHS: {
                status = napi_create_array(env, &result);
                size_t offset = 0;
                for (uint32_t index = 0; status == napi_ok && offset < request->length; index++) {
                    const char *path = (const char *)request->data + offset;
                    const char *end = memchr(path, 0, request->length - offset);
                    if (!end) { status = napi_invalid_arg; break; }
                    napi_value item;
                    status = napi_create_string_utf8(env, path, (size_t)(end - path), &item);
                    if (status == napi_ok) status = napi_set_element(env, result, index, item);
                    offset += (size_t)(end - path) + 1;
                }
                break;
            }
        }
        if (status != napi_ok) request->error = "Could not create clipboard value";
    }
    if (request->error) {
        napi_value message;
        napi_create_string_utf8(env, request->error, NAPI_AUTO_LENGTH, &message);
        napi_create_error(env, NULL, message, &result);
        napi_reject_deferred(env, request->deferred, result);
    } else napi_resolve_deferred(env, request->deferred, result);
    napi_delete_async_work(env, request->work);
    free(request->data);
    free(request);
}
static napi_value clipboard_call(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argument;
    void *operation;
    napi_get_cb_info(env, info, &argc, &argument, NULL, &operation);
    ClipboardRequest *request = calloc(1, sizeof(*request));
    if (!request) { napi_throw_error(env, NULL, "Out of memory"); return NULL; }
    request->operation = (Operation)(uintptr_t)operation;
    if (request->operation == WRITE_TEXT) {
#ifdef _WIN32
        napi_status status = argc ? napi_get_value_string_utf16(env, argument, NULL, 0, &request->length) : napi_invalid_arg;
        const size_t unit = sizeof(uint16_t);
#else
        napi_status status = argc ? napi_get_value_string_utf8(env, argument, NULL, 0, &request->length) : napi_invalid_arg;
        const size_t unit = 1;
#endif
        if (status != napi_ok) { free(request); napi_throw_error(env, NULL, "setText requires a string"); return NULL; }
        request->data = request->length < SIZE_MAX / unit ? calloc(request->length + 1, unit) : NULL;
        if (request->data) {
#ifdef _WIN32
            status = napi_get_value_string_utf16(env, argument, request->data, request->length + 1, &request->length);
#else
            status = napi_get_value_string_utf8(env, argument, request->data, request->length + 1, &request->length);
#endif
        }
        if (!request->data || status != napi_ok) {
            free(request->data); free(request);
            napi_throw_error(env, NULL, "Could not read clipboard text"); return NULL;
        }
    }
    napi_value name, promise;
    napi_status status = napi_create_string_utf8(env, "axi.clipboard", NAPI_AUTO_LENGTH, &name);
    if (status == napi_ok) status = napi_create_async_work(env, NULL, name, run_clipboard, settle_clipboard, request, &request->work);
    if (status == napi_ok) status = napi_create_promise(env, &request->deferred, &promise);
    if (status == napi_ok) status = napi_queue_async_work(env, request->work);
    if (status != napi_ok) {
        if (request->work) napi_delete_async_work(env, request->work);
        free(request->data); free(request);
        napi_throw_error(env, NULL, "Could not queue clipboard operation"); return NULL;
    }
    return promise;
}
static void export_clipboard(napi_env env, napi_value exports, size_t count) {
    napi_property_descriptor methods[] = {
        {"getText", NULL, clipboard_call, NULL, NULL, NULL, napi_default, (void *)(uintptr_t)READ_TEXT},
        {"getImage", NULL, clipboard_call, NULL, NULL, NULL, napi_default, (void *)(uintptr_t)READ_IMAGE},
        {"setText", NULL, clipboard_call, NULL, NULL, NULL, napi_default, (void *)(uintptr_t)WRITE_TEXT},
        {"getFilePaths", NULL, clipboard_call, NULL, NULL, NULL, napi_default, (void *)(uintptr_t)READ_FILES},
    };
    napi_define_properties(env, exports, count, methods);
}
#endif
