(format t "Hello, Common Lisp!~%")
(loop for i from 1 to 5
      do (format t "~a squared is ~a~%" i (* i i)))
