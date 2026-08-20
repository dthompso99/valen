#include <stdio.h>
int main(int c,char**v){FILE*f=fopen(v[1],"rb");unsigned char b[4096];unsigned long long s=0;size_t n;while((n=fread(b,1,sizeof b,f)))for(size_t i=0;i<n;i++)s+=b[i];fclose(f);printf("%llu\n",s);}
