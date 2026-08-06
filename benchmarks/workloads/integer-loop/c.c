#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>

int main(void) {
    volatile int64_t checksum = 0;
    for (int64_t index = 0; index < INT64_C(1000000000); index++) {
        int64_t value = index * 17;
        checksum += value - ((value / 251) * 251);
    }
    printf("%" PRId64 "\n", checksum);
    return 0;
}
