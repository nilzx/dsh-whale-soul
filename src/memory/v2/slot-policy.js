const aliases = new Map([
  ['preference.color', ['preference.color.favorite', 'favorite.color', 'favorite_color']],
  ['preference.drink', ['preference.drink.favorite', 'favorite.drink', 'favorite_drink', 'preference.beverage']],
  ['preference.food', ['preference.food.favorite', 'favorite.food', 'favorite_food']],
  ['preference.food.sweetness', ['preference.sweetness', 'preference.dessert.sweetness', 'preference.snack.sweetness']],
  ['identity.name', ['profile.name', 'preferred_name', 'user.name']],
  ['preference.address', ['preferred_address', 'preference.nickname']],
  ['preference.music', ['favorite.music', 'preference.music.favorite']],
  ['preference.language', ['preferred_language', 'language.preferred']],
].flatMap(([canonical, values]) => [canonical, ...values].map((value) => [value, canonical])))

/** Known aliases share a predicate; unknown keys retain exact-key semantics. */
export const normalizeMemorySlotKey = (key) => aliases.get(key) ?? key
export const isKnownMemorySlotKey = (key) => aliases.has(key)
