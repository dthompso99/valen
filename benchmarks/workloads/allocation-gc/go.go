package main
import "fmt"
type BoxValue struct{value int64}
func main(){var c int64=1;for i:=int64(0);i<500000;i++{b:=&BoxValue{(i^c)&2147483647};c=(c+b.value)&2147483647};fmt.Println(c)}
