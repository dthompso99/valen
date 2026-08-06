package main

import "fmt"

func main() {
	var checksum int64
	for index := int64(0); index < 1000000000; index++ {
		value := index * 17
		checksum += value - ((value / 251) * 251)
	}
	fmt.Println(checksum)
}
