(display "Hello, Scheme!")
(newline)

(define (fact n)
  (if (= n 0) 1 (* n (fact (- n 1)))))

(display "10! = ")
(display (fact 10))
(newline)
