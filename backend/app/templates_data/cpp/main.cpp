#include <print>
#include <ranges>
#include <string>
#include <vector>

int main() {
    std::vector<std::string> words{"Hello", "from", "modern", "C++!"};
    std::println("{}", words | std::views::join_with(' ') | std::ranges::to<std::string>());
    for (auto [i, w] : std::views::enumerate(words)) std::println("{}: {}", i, w);
}
