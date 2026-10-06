#include <iostream>
#include <string>
#include <vector>

int main() {
    std::vector<std::string> words{"Hello", "from", "C++17!"};
    for (const auto& w : words) std::cout << w << ' ';
    std::cout << '\n';
    return 0;
}
