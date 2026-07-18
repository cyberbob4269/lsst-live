"""Sample module so the Vera Terminal explorer has something to open."""


def greet(name: str) -> str:
    return f"Hello, {name}! Welcome to Vera Terminal."


if __name__ == "__main__":
    print(greet("explorer"))
