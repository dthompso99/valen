package main
import "fmt"
func main(){var checksum int64;for i:=0;i<50000;i++{out:=make([]byte,0,13);if i&1==0{out=append(out,"valen-"...)}else{out=append(out,"argon-"...)};out=append(out,"runtime"...);checksum+=int64(len(out))};fmt.Println(checksum)}
