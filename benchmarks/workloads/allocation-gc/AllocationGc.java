final class BoxValue{final long value;BoxValue(long value){this.value=value;}}
public final class AllocationGc{public static void main(String[]args){long c=1;for(long i=0;i<500000;i++){BoxValue b=new BoxValue((i^c)&2147483647);c=(c+b.value)&2147483647;}System.out.println(c);}}
