print "What's your name? "
name = (gets || "world").strip
puts "Hello, #{name}! Ruby #{RUBY_VERSION} here."
3.times { |i| puts "#{i + 1}. :)" }
