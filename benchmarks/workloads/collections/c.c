#include <stdint.h>
#include <stdio.h>
int main(void){int64_t v[4096]={0},a[10000];for(int64_t i=0;i<10000;i++)v[i&4095]=i,a[i]=i;int64_t s=0;for(int i=0;i<4096;i++){s+=v[i];if((i&1)==0)s+=v[i];}for(int i=0;i<10000;i++)s+=a[i];for(int i=9999;i>=5000;i--)s+=a[i];printf("%lld\n",(long long)s);}
