#include <cstdint>
#include <iostream>
#include <string>
int main() { std::int64_t checksum=0; for(std::int64_t i=0;i<50000;i++){ std::string out; out.append((i&1)?"argon-":"valen-"); out.append("runtime"); checksum += out.size(); } std::cout<<checksum<<'\n'; }
