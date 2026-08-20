package main
import("fmt";"os")
func main(){f,_:=os.Open(os.Args[1]);defer f.Close();b:=make([]byte,4096);var s uint64;for{n,_:=f.Read(b);if n==0{break};for _,x:=range b[:n]{s+=uint64(x)}};fmt.Println(s)}
