public final class IntegerLoop {
    public static void main(String[] arguments) {
        long checksum = 0;
        for (long index = 0; index < 1_000_000_000L; index++) {
            long value = index * 17;
            checksum += value - ((value / 251) * 251);
        }
        System.out.println(checksum);
    }
}
