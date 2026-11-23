import { Component } from "@angular/core";
import { Badge } from "./badge";

/** A card, whose template binds a string to a number: an error only strict templates report. */
@Component({ selector: "app-card", imports: [Badge], templateUrl: "./card.html" })
export class Card {
  readonly title = "Cart";
}
