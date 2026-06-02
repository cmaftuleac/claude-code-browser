package main

import (
	"fmt"
	"net/http"
	"time"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "%s %s\n", time.Now().UTC().Format(time.RFC3339), r.URL.Path)
	})
	srv := &http.Server{Addr: ":8080", Handler: mux, ReadTimeout: 5 * time.Second}
	fmt.Println("listening on :8080")
	if err := srv.ListenAndServe(); err != nil {
		panic(err)
	}
}
