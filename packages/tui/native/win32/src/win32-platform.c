#include <windows.h>
#include "../../clipboard.h"
#ifndef ENABLE_VIRTUAL_TERMINAL_INPUT
#define ENABLE_VIRTUAL_TERMINAL_INPUT 0x0200
#endif
static uint16_t little16(const unsigned char *p) { return (uint16_t)p[0] | (uint16_t)p[1] << 8; }
static uint32_t little32(const unsigned char *p) {
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}
static void store32(unsigned char *p, uint32_t value) {
    for (unsigned i = 0; i < 4; i++) p[i] = (unsigned char)(value >> (8 * i));
}
static size_t pixels(const unsigned char *data, size_t size) {
    if (size < 12) return 0;
    uint32_t header = little32(data);
    uint64_t offset;
    if (header == 12) {
        uint16_t bits = little16(data + 10);
        offset = 12 + (bits <= 8 ? (uint64_t)(1u << bits) * 3 : 0);
    } else {
        if (header < 40 || header > size) return 0;
        uint16_t bits = little16(data + 14);
        uint32_t compression = little32(data + 16), colors = little32(data + 32);
        if (!colors && bits <= 8) colors = 1u << bits;
        offset = (uint64_t)header + (uint64_t)colors * 4;
        if (header == 40 && compression == 3) offset += 12;
        if (header == 40 && compression == 6) offset += 16;
    }
    return offset <= size ? (size_t)offset : 0;
}
static void clipboard_image(ClipboardRequest *request) {
    UINT png = RegisterClipboardFormatW(L"PNG");
    bool has_png = png && IsClipboardFormatAvailable(png);
    if (!has_png && !IsClipboardFormatAvailable(CF_DIBV5) && !IsClipboardFormatAvailable(CF_DIB)) {
        request->encoding = EMPTY; return;
    }
    HGLOBAL handle = has_png ? (HGLOBAL)GetClipboardData(png) : NULL;
    bool encoded = handle != NULL;
    if (!handle && IsClipboardFormatAvailable(CF_DIBV5)) handle = (HGLOBAL)GetClipboardData(CF_DIBV5);
    if (!handle && IsClipboardFormatAvailable(CF_DIB)) handle = (HGLOBAL)GetClipboardData(CF_DIB);
    const unsigned char *data = handle ? GlobalLock(handle) : NULL;
    size_t size = handle ? GlobalSize(handle) : 0;
    if (!data || !size) {
        if (data) GlobalUnlock(handle);
        request->error = "Clipboard does not contain an image"; return;
    }
    if (encoded) save_bytes(request, data, size, BINARY);
    else {
        size_t offset = pixels(data, size);
        unsigned char *bitmap = offset && size <= UINT32_MAX - 14 ? calloc(1, size + 14) : NULL;
        if (!bitmap) request->error = "Could not create clipboard image buffer";
        else {
            bitmap[0] = 'B'; bitmap[1] = 'M';
            store32(bitmap + 2, (uint32_t)(size + 14));
            store32(bitmap + 10, (uint32_t)(offset + 14));
            memcpy(bitmap + 14, data, size);
            request->data = bitmap; request->length = size + 14; request->encoding = BINARY;
        }
    }
    GlobalUnlock(handle);
}
static void platform_clipboard(ClipboardRequest *request) {
    HWND owner = NULL;
    if (request->operation == WRITE_TEXT) {
        owner = CreateWindowExW(0, L"STATIC", NULL, 0, 0, 0, 0, 0, HWND_MESSAGE, NULL, GetModuleHandleW(NULL), NULL);
        if (!owner) { request->error = "Could not create clipboard owner window"; return; }
    }
    bool opened = false;
    for (unsigned attempt = 0; attempt < 10 && !opened; attempt++) {
        opened = OpenClipboard(owner) != 0;
        if (!opened) Sleep(5);
    }
    if (!opened) request->error = "Could not open clipboard";
    else {
        switch (request->operation) {
            case WRITE_TEXT: {
                size_t size = (request->length + 1) * sizeof(uint16_t);
                HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, size);
                void *text = memory ? GlobalLock(memory) : NULL;
                bool written = false;
                if (text) {
                    memcpy(text, request->data, size);
                    GlobalUnlock(memory);
                    written = EmptyClipboard() && SetClipboardData(CF_UNICODETEXT, memory) != NULL;
                }
                if (!written) {
                    if (memory) GlobalFree(memory);
                    request->error = "Could not set clipboard text";
                }
                break;
            }
            case READ_TEXT: {
                if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) { request->encoding = EMPTY; break; }
                HGLOBAL memory = (HGLOBAL)GetClipboardData(CF_UNICODETEXT);
                const uint16_t *text = memory ? GlobalLock(memory) : NULL;
                if (!text) request->error = "Clipboard does not contain text";
                else {
                    size_t size = GlobalSize(memory) / sizeof(uint16_t), count = 0;
                    while (count < size && text[count]) count++;
                    save_bytes(request, text, count * sizeof(uint16_t), UTF16);
                    GlobalUnlock(memory);
                }
                break;
            }
            case READ_IMAGE: clipboard_image(request); break;
            case READ_FILES: request->encoding = EMPTY; break;
        }
        CloseClipboard();
    }
    if (owner) DestroyWindow(owner);
}
static bool pressed(int key) { return ((unsigned short)GetAsyncKeyState(key) & 0x8000) != 0; }
static napi_value modifier(napi_env env, napi_callback_info info) {
    size_t count = 1, length;
    napi_value argument, result;
    char name[16] = {0};
    bool down = false;
    napi_get_cb_info(env, info, &count, &argument, NULL, NULL);
    if (count && napi_get_value_string_utf8(env, argument, name, sizeof(name), &length) == napi_ok) {
        if (!strcmp(name, "shift")) down = pressed(VK_SHIFT) || pressed(VK_LSHIFT) || pressed(VK_RSHIFT);
        else if (!strcmp(name, "control")) down = pressed(VK_CONTROL) || pressed(VK_LCONTROL) || pressed(VK_RCONTROL);
        else if (!strcmp(name, "option") || !strcmp(name, "alt")) down = pressed(VK_MENU) || pressed(VK_LMENU) || pressed(VK_RMENU);
        else if (!strcmp(name, "command") || !strcmp(name, "super") || !strcmp(name, "win")) down = pressed(VK_LWIN) || pressed(VK_RWIN);
    }
    napi_get_boolean(env, down, &result); return result;
}
static napi_value virtual_input(napi_env env, napi_callback_info info) {
    (void)info;
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    DWORD mode;
    bool enabled = input != INVALID_HANDLE_VALUE && GetConsoleMode(input, &mode) && SetConsoleMode(input, mode | ENABLE_VIRTUAL_TERMINAL_INPUT);
    napi_value result; napi_get_boolean(env, enabled, &result); return result;
}
NAPI_MODULE_INIT() {
    export_clipboard(env, exports, 3);
    napi_property_descriptor methods[] = {
        {"isModifierPressed", NULL, modifier, NULL, NULL, NULL, napi_default, NULL},
        {"enableVirtualTerminalInput", NULL, virtual_input, NULL, NULL, NULL, napi_default, NULL},
    };
    napi_define_properties(env, exports, 2, methods);
    return exports;
}
