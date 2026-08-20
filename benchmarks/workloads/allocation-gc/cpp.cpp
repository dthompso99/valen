#include <cstdint>
#include <iostream>
#include <memory>
struct Box{std::int64_t value;explicit Box(std::int64_t v):value(v){}};
int main(){std::int64_t c=1;for(std::int64_t i=0;i<500000;i++){auto b=std::make_unique<Box>((i^c)&2147483647);c=(c+b->value)&2147483647;}std::cout<<c<<'\n';}
