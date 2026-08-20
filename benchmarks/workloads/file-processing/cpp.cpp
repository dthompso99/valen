#include <fstream>
#include <iostream>
int main(int c,char**v){std::ifstream f(v[1],std::ios::binary);unsigned long long s=0;char b[4096];while(f){f.read(b,sizeof b);for(std::streamsize i=0;i<f.gcount();i++)s+=(unsigned char)b[i];}std::cout<<s<<'\n';}
