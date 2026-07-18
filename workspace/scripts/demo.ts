// Sample TypeScript file — Monaco should pick up ts highlighting + worker.
export interface Greeting {
  name: string;
  excited: boolean;
}

export function greet({ name, excited }: Greeting): string {
  const base = `Hello, ${name}!`;
  return excited ? `${base} 🚀` : base;
}

console.log(greet({ name: "Vera", excited: true }));
