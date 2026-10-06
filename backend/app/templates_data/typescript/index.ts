interface Greeting {
  who: string;
  times: number;
}

function greet({ who, times }: Greeting): string[] {
  return Array.from({ length: times }, (_, i) => `${i + 1}. Hello, ${who}!`);
}

greet({ who: "TypeScript", times: 3 }).forEach((line) => console.log(line));
