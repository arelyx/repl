const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("What's your name? ", (name) => {
  console.log(`Hello, ${name}! Node ${process.version} says hi.`);
  rl.close();
});
