Console.Write("What's your name? ");
var name = Console.ReadLine();
if (string.IsNullOrWhiteSpace(name)) name = "world";
Console.WriteLine($"Hello, {name}! Running on .NET {Environment.Version}.");
