fun main() {
    val langs = listOf("Kotlin", "Java", "Scala")
    langs.forEachIndexed { i, l -> println("${i + 1}. Hello from $l!") }
}
