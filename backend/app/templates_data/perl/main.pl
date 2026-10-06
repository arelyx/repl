use strict;
use warnings;

print "Hello, Perl!\n";
my @langs = qw(Perl Python Ruby);
print join(", ", map { "$_!" } @langs), "\n";
