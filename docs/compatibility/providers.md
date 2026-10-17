# Provider compatibility

| Provider          | basic-response | streaming | system-prompt | multi-turn-conversation | tool-call | tool-result | multiple-tool-calls | errors | usage | cancellation | thinking | prompt-caching | structured-output | context-management |
| ----------------- | -------------- | --------- | ------------- | ----------------------- | --------- | ----------- | ------------------- | ------ | ----- | ------------ | -------- | -------------- | ----------------- | ------------------ |
| anthropic         | ✓              | ✓         | ✓             | ✓                       | ✓         | ✓           | ✓                   | ✓      | ✓     | ✓            | ✓        | -              | ✓                 | ✓                  |
| openai            | n/d            | n/d       | n/d           | n/d                     | n/d       | n/d         | n/d                 | n/d    | n/d   | n/d          | n/d      | n/d            | n/d               | n/d                |
| azure-openai      | ✓              | ✓         | ✓             | ✓                       | ✓         | ✓           | ✓                   | ✓      | ✓     | ✓            | -        | -              | ✓                 | -                  |
| openai-compatible | n/d            | n/d       | n/d           | n/d                     | n/d       | n/d         | n/d                 | n/d    | n/d   | n/d          | n/d      | n/d            | n/d               | n/d                |

Legend:

```text
✓ native/compatible
~ approximated
- unsupported
```

✗ conformance test failed
? not verified in this build
n/d not derivable from the available scenario or out of release scope

Fixture basis:

- anthropic: recorded-fixture conformance; no live provider credential was available.
- openai: out of the tested 0.1.0 provider scope under D-03.
- azure-openai: recorded-fixture conformance; no live provider credential was available.
- openai-compatible: out of the tested 0.1.0 provider scope under D-03.
