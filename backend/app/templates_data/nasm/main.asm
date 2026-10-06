; x86-64 Linux hello world
        global  _start

        section .text
_start:
        mov     rax, 1          ; sys_write
        mov     rdi, 1          ; stdout
        mov     rsi, msg
        mov     rdx, len
        syscall

        mov     rax, 60         ; sys_exit
        xor     rdi, rdi
        syscall

        section .data
msg:    db      "Hello, Assembly!", 10
len:    equ     $ - msg
