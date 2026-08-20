#include <stdint.h>
#include <stdio.h>

typedef int64_t (*apply_fn)(int64_t);
static int64_t base_apply(int64_t value) { return value + 1; }
static int64_t child_apply(int64_t value) { return value + 2; }

int main(void) {
    apply_fn virtual_apply = child_apply;
    apply_fn contract_apply = child_apply;
    int64_t checksum = 1;
    for (int64_t index = 0; index < 50000000; ++index) {
        checksum = (checksum + base_apply((index ^ checksum) & 2147483647)) & 2147483647;
        checksum = (checksum + virtual_apply((index ^ checksum) & 2147483647)) & 2147483647;
        checksum = (checksum + contract_apply((index ^ checksum) & 2147483647)) & 2147483647;
    }
    printf("%lld\n", (long long)checksum);
    return 0;
}
