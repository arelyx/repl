<?php
echo "Hello, PHP " . PHP_VERSION . "!\n";
foreach (["apples", "bananas", "cherries"] as $i => $fruit) {
    echo ($i + 1) . ". $fruit\n";
}
