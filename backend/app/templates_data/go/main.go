package main

import (
	"fmt"
	"runtime"
)

func main() {
	fmt.Printf("Hello, Go! (%s on %s/%s)\n", runtime.Version(), runtime.GOOS, runtime.GOARCH)
	for i := 1; i <= 3; i++ {
		fmt.Println("gopher", i)
	}
}
