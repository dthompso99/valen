#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
typedef struct { int64_t value; } Box;
int main(void){int64_t c=1;for(int64_t i=0;i<500000;i++){Box*b=malloc(sizeof(Box));b->value=(i^c)&2147483647;c=(c+b->value)&2147483647;free(b);}printf("%lld\n",(long long)c);}
