package main
import("fmt";"strconv")
func main(){m:=map[string]int64{};a:=make([]int64,0,10000);for i:=int64(0);i<10000;i++{m["k"+strconv.FormatInt(i&4095,10)]=i;a=append(a,i)};var s int64;for i:=int64(0);i<4096;i++{k:="k"+strconv.FormatInt(i,10);s+=m[k];if i&1==0{s+=m[k];delete(m,k)}};for _,v:=range a{s+=v};for len(a)>5000{s+=a[len(a)-1];a=a[:len(a)-1]};fmt.Println(s)}
