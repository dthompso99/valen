interface Operation { long apply(long value); }
class Base { long apply(long value) { return value + 1; } }
final class Child extends Base implements Operation { @Override public long apply(long value) { return value + 2; } }

public final class ObjectDispatch {
    public static void main(String[] args) {
        Base base = new Base();
        Child child = new Child();
        Base virtualValue = child;
        Operation contract = child;
        long checksum = 1;
        for (long index = 0; index < 50000000; ++index) {
            checksum = (checksum + base.apply((index ^ checksum) & 2147483647)) & 2147483647;
            checksum = (checksum + virtualValue.apply((index ^ checksum) & 2147483647)) & 2147483647;
            checksum = (checksum + contract.apply((index ^ checksum) & 2147483647)) & 2147483647;
        }
        System.out.println(checksum);
    }
}
