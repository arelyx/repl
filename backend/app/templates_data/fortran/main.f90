program hello
  implicit none
  integer :: i
  print *, "Hello, Fortran!"
  do i = 1, 5
    print *, i, i**2
  end do
end program hello
