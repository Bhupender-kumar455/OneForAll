import type { RunnerLanguage } from '../types.ts';

/**
 * Every language the runner offers, and everything language-specific about it.
 *
 * Provider ids live here and nowhere else: the UI passes `id` straight through,
 * the API layer decides what to do with it. Ids are for the public Judge0 CE
 * catalogue (https://ce.judge0.com/languages) and were verified against it —
 * this is the only place that needs revisiting if the provider is swapped.
 *
 * Only languages confirmed runnable on that instance are listed. Anything the
 * provider rejects would surface as a 400 from our own API, which is more
 * confusing than simply not offering it.
 */
export const RUNNER_LANGUAGES: RunnerLanguage[] = [
  {
    id: 109,
    name: 'Python 3.13',
    short: 'Python',
    runtime: 'CPython 3.13.2',
    extension: '.py',
    monaco: 'python',
    defaultCode: `def main():
    print("Hello, world!")


if __name__ == "__main__":
    main()
`,
  },
  {
    id: 102,
    name: 'JavaScript (Node.js 22)',
    short: 'JavaScript',
    runtime: 'Node.js 22.08',
    extension: '.js',
    monaco: 'javascript',
    defaultCode: `const greet = (name) => \`Hello, \${name}!\`;

console.log(greet('world'));
`,
  },
  {
    id: 101,
    name: 'TypeScript (5.6)',
    short: 'TypeScript',
    runtime: 'TypeScript 5.6.2',
    extension: '.ts',
    monaco: 'typescript',
    defaultCode: `function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

console.log(greet('world'));
`,
  },
  {
    id: 103,
    name: 'C (GCC 14.1)',
    short: 'C',
    runtime: 'GCC 14.1.0',
    extension: '.c',
    monaco: 'c',
    defaultCode: `#include <stdio.h>

int main(void) {
    printf("Hello, world!\\n");
    return 0;
}
`,
  },
  {
    id: 105,
    name: 'C++ (GCC 14.1)',
    short: 'C++',
    runtime: 'GCC 14.1.0',
    extension: '.cpp',
    monaco: 'cpp',
    defaultCode: `#include <iostream>

int main() {
    std::cout << "Hello, world!" << std::endl;
    return 0;
}
`,
  },
  {
    id: 91,
    name: 'Java (JDK 17)',
    short: 'Java',
    runtime: 'OpenJDK 17.0.6',
    extension: '.java',
    monaco: 'java',
    defaultCode: `public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, world!");
    }
}
`,
  },
  {
    id: 51,
    name: 'C# (Mono 6.6)',
    short: 'C#',
    runtime: 'Mono 6.6.0',
    extension: '.cs',
    monaco: 'csharp',
    defaultCode: `using System;

class Program {
    static void Main() {
        Console.WriteLine("Hello, world!");
    }
}
`,
  },
  {
    id: 107,
    name: 'Go (1.23)',
    short: 'Go',
    runtime: 'Go 1.23.5',
    extension: '.go',
    monaco: 'go',
    defaultCode: `package main

import "fmt"

func main() {
	fmt.Println("Hello, world!")
}
`,
  },
  {
    id: 108,
    name: 'Rust (1.85)',
    short: 'Rust',
    runtime: 'Rust 1.85.0',
    extension: '.rs',
    monaco: 'rust',
    defaultCode: `fn main() {
    println!("Hello, world!");
}
`,
  },
  {
    id: 98,
    name: 'PHP (8.3)',
    short: 'PHP',
    runtime: 'PHP 8.3.11',
    extension: '.php',
    monaco: 'php',
    defaultCode: `<?php

echo "Hello, world!\\n";
`,
  },
  {
    id: 72,
    name: 'Ruby (2.7)',
    short: 'Ruby',
    runtime: 'Ruby 2.7.0',
    extension: '.rb',
    monaco: 'ruby',
    defaultCode: `puts 'Hello, world!'
`,
  },
  {
    id: 111,
    name: 'Kotlin (2.1)',
    short: 'Kotlin',
    runtime: 'Kotlin 2.1.10',
    extension: '.kt',
    monaco: 'kotlin',
    defaultCode: `fun main() {
    println("Hello, world!")
}
`,
  },
  {
    id: 83,
    name: 'Swift (5.2)',
    short: 'Swift',
    runtime: 'Swift 5.2.3',
    extension: '.swift',
    monaco: 'swift',
    defaultCode: `print("Hello, world!")
`,
  },
  {
    id: 82,
    name: 'SQL (SQLite 3.27)',
    short: 'SQL',
    runtime: 'SQLite 3.27.2',
    extension: '.sql',
    monaco: 'sql',
    defaultCode: `CREATE TABLE greeting (message TEXT);
INSERT INTO greeting VALUES ('Hello, world!');
SELECT message FROM greeting;
`,
  },
  {
    id: 46,
    name: 'Bash (5.0)',
    short: 'Bash',
    runtime: 'Bash 5.0.0',
    extension: '.sh',
    monaco: 'shell',
    defaultCode: `greeting="Hello, world!"
echo "$greeting"
`,
  },
];

/**
 * Does this extension belong to something the runner can execute?
 *
 * Used to tell the user *why* a pasted snippet is not runnable, rather than
 * accepting it and letting the provider produce a compiler error about it.
 */
const RUNNABLE_EXTENSIONS = new Set(RUNNER_LANGUAGES.map((language) => language.extension));

export function isRunnableExtension(extension: string | null): boolean {
  if (!extension) return false;
  return RUNNABLE_EXTENSIONS.has(extension.toLowerCase());
}

/** Case-insensitive lookup by Monaco language id, for pre-filling sample code. */
export function languageByMonacoId(monacoId: string): RunnerLanguage | undefined {
  const needle = monacoId.toLowerCase();
  return RUNNER_LANGUAGES.find((language) => language.monaco === needle);
}