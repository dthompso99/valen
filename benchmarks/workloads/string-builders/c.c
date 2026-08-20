#include <stdint.h>
#include <stdio.h>
#include <string.h>
int main(void) { int64_t checksum = 0; for (int64_t i=0;i<50000;i++) { char out[14]; strcpy(out,(i&1)?"argon-":"valen-"); strcat(out,"runtime"); checksum += (int64_t)strlen(out); } printf("%lld\n",(long long)checksum); }
