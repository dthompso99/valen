package main

import "fmt"

type Operation interface { Apply(int64) int64 }
type Base struct{}
type Child struct{}
func (Base) Apply(value int64) int64 { return value + 1 }
func (Child) Apply(value int64) int64 { return value + 2 }

func main() {
    base := Base{}
    child := Child{}
    var virtualValue Operation = child
    var contract Operation = child
    var checksum int64 = 1
    for index := int64(0); index < 50000000; index++ {
        checksum = (checksum + base.Apply((index ^ checksum) & 2147483647)) & 2147483647
        checksum = (checksum + virtualValue.Apply((index ^ checksum) & 2147483647)) & 2147483647
        checksum = (checksum + contract.Apply((index ^ checksum) & 2147483647)) & 2147483647
    }
    fmt.Println(checksum)
}
