#include <cstdint>
#include <iostream>

struct Operation { virtual std::int64_t apply(std::int64_t value) = 0; virtual ~Operation() = default; };
struct Base { virtual std::int64_t apply(std::int64_t value) { return value + 1; } virtual ~Base() = default; };
struct Child final : Base, Operation { std::int64_t apply(std::int64_t value) override { return value + 2; } };

int main() {
    Base base;
    Child child;
    Base* virtual_value = &child;
    Operation* contract = &child;
    std::int64_t checksum = 1;
    for (std::int64_t index = 0; index < 50000000; ++index) {
        checksum = (checksum + base.apply((index ^ checksum) & 2147483647)) & 2147483647;
        checksum = (checksum + virtual_value->apply((index ^ checksum) & 2147483647)) & 2147483647;
        checksum = (checksum + contract->apply((index ^ checksum) & 2147483647)) & 2147483647;
    }
    std::cout << checksum << '\n';
}
