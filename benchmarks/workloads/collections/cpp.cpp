#include <cstdint>
#include <iostream>
#include <string>
#include <unordered_map>
#include <vector>
int main(){std::unordered_map<std::string,std::int64_t>m;std::vector<std::int64_t>a;for(std::int64_t i=0;i<10000;i++)m["k"+std::to_string(i&4095)]=i,a.push_back(i);std::int64_t s=0;for(int i=0;i<4096;i++){auto k="k"+std::to_string(i);s+=m[k];if((i&1)==0){s+=m[k];m.erase(k);}}for(auto v:a)s+=v;while(a.size()>5000){s+=a.back();a.pop_back();}std::cout<<s<<'\n';}
