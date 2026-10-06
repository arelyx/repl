#include <stdio.h>
#include <math.h>

int main(void) {
    printf("Hello, C!\n");
    for (int i = 1; i <= 5; i++)
        printf("sqrt(%d) = %.3f\n", i, sqrt(i));
    return 0;
}
