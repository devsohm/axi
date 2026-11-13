#include <stdio.h>
#include <sys/ioctl.h>

int main(void) {
    struct winsize size;
    if (ioctl(0, TIOCGWINSZ, &size) != 0) {
        perror("terminal size");
        return 1;
    }
    printf("%hu %hu\n", size.ws_row, size.ws_col);
    return 0;
}
