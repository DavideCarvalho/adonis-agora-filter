# `@adonis-agora/filter-client`

Framework-agnostic client-side query builder for [`@adonis-agora/filter`](https://github.com/DavideCarvalho/adonis-filter)
— fluently build filter/sort/pagination query strings, with optional TanStack
Table state sync.

```ts
import { filterQuery } from '@adonis-agora/filter-client'

const qs = filterQuery()
  .where('status', 'eq', 'active')
  .where('age', 'gte', 18)
  .sort('createdAt', 'desc')
  .page(1, 25)
  .toQueryString()
// → filter[status]=active&filter[age][gte]=18&sort=-createdAt&page=1&size=25
```

## License

MIT © Davi Carvalho
