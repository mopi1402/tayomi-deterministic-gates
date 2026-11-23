import { greet } from "./greet";

describe("greet", () => {
  it("greets someone by name", () => {
    expect(greet("Ada")).toBe("Hello, Ada!");
  });
});
