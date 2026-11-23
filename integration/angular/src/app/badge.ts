import { Component, input } from "@angular/core";

/** A count, with the label that says what it counts. */
@Component({ selector: "app-badge", template: "<span>{{ label() }} {{ count() }}</span>" })
export class Badge {
  readonly count = input(0);
  readonly label = input("");
}
