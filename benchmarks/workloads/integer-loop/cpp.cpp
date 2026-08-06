#include <cstdint>
#include <iostream>

int main() {
    volatile std::int64_t checksum = 0;
    for (std::int64_t index = 0; index < 1000000000LL; ++index) {
        const std::int64_t value = index * 17;
        checksum = checksum + value - ((value / 251) * 251);
    }
    std::cout << checksum << '\n';
}
