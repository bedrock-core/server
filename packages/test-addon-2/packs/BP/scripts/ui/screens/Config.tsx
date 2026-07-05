import { Fragment, Panel, Scroll, Text, useContext, useState, type JSX } from '@bedrock-core/ui-runtime';
import { Button, Card, Divider, Dropdown, Input, Slider, Toggle, theme } from '@bedrock-core/ore-styled';
import { CoreContext } from '../CoreContext';
import {
  buildNestedPatch,
  filterScope,
  getScopedSchema,
  getScopeValues,
  groupByTopLevel,
  patchScope,
  resolveInitialValue,
  type EntrySchema,
} from '../configUtils';
import type { AppScreen } from '../routes';

const { spacing, fontColor } = theme.tokens;

const NUMBER_INLINE_MAX_RANGE = 100;

export function Config({ navigation, route }: AppScreen<'Config'>): JSX.Element {
  const core = useContext(CoreContext)!;
  const { addonId, scope, entityId, breadcrumb } = route.params;
  const accessor = core.config.of(addonId)!;
  const schema = filterScope(getScopedSchema(accessor), scope);
  const currentValues = getScopeValues(accessor, scope, entityId);

  const [staged, setStaged] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(schema)) {
      init[key] = resolveInitialValue(key, entry, currentValues);
    }

    return init;
  });

  const [listStaged, setListStaged] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {};
    for (const [key, entry] of Object.entries(schema)) {
      if (entry.type === 'list') {
        const val = resolveInitialValue(key, entry, currentValues);
        init[key] = Array.isArray(val) ? (val as string[]) : [];
      }
    }

    return init;
  });

  function handleSave(): void {
    const combined: Record<string, unknown> = { ...staged };
    for (const [k, arr] of Object.entries(listStaged)) {
      combined[k] = JSON.stringify(arr);
    }
    patchScope(accessor, scope, entityId, buildNestedPatch(combined));
    navigation.goBack();
  }

  const groups = groupByTopLevel(schema);

  return (
    <Card flexDirection={'column'} padding={12} gap={spacing.sm}>
      <Text font={'minecraftTen'} scale={1.5}>{breadcrumb}</Text>
      <Divider />
      <Scroll>
        <Panel flexDirection={'column'} gap={spacing.sm}>
          {[...groups.entries()].map(([groupName, entries]) => (
            <Fragment>
              {groupName !== '' ? (
                <Text font={'minecraftTen'}>{`${fontColor.muted}${groupName.charAt(0).toUpperCase()}${groupName.slice(1)}`}</Text>
              ) : null}
              <Panel flexDirection={'column'} gap={spacing.xs}>
                {entries.map(([subKey, entry]) => {
                  const fullKey = groupName ? `${groupName}.${subKey}` : subKey;

                  return (
                    <Fragment>
                      {renderField(fullKey, entry, staged, setStaged, listStaged, setListStaged, navigation, route.params)}
                    </Fragment>
                  );
                })}
              </Panel>
              <Divider variant={'light'} />
            </Fragment>
          ))}
        </Panel>
      </Scroll>
      <Panel flexDirection={'row'} gap={spacing.xs}>
        <Button flexGrow={1} onPress={handleSave}>{'Save'}</Button>
        <Button flexGrow={1} variant={'secondary'} onPress={(): void => navigation.goBack()}>{'Cancel'}</Button>
      </Panel>
    </Card>
  );
}

type SetStaged = (fn: (prev: Record<string, unknown>) => Record<string, unknown>) => void;
type SetListStaged = (fn: (prev: Record<string, string[]>) => Record<string, string[]>) => void;

function renderField(
  fullKey: string,
  entry: EntrySchema,
  staged: Record<string, unknown>,
  setStaged: SetStaged,
  listStaged: Record<string, string[]>,
  setListStaged: SetListStaged,
  navigation: AppScreen<'Config'>['navigation'],
  routeParams: AppScreen<'Config'>['route']['params'],
): JSX.Element {
  const currentVal = staged[fullKey] ?? entry.default;
  const label = entry.label;
  const desc = entry.description ? `\n${fontColor.muted}${entry.description}` : '';

  if (entry.type === 'boolean') {
    return (
      <Panel flexDirection={'row'} alignItems={'center'} gap={spacing.xs}>
        <Text flexGrow={1}>{`${label}${desc}`}</Text>
        <Toggle
          on={Boolean(currentVal)}
          onChange={(on): void => { setStaged(prev => ({ ...prev, [fullKey]: on })); }}
        />
      </Panel>
    );
  }

  if (entry.type === 'number') {
    const min = entry.min ?? 0;
    const max = entry.max ?? 100;
    const numVal = typeof currentVal === 'number' ? currentVal : Number(currentVal ?? 0);

    if ((max - min) <= NUMBER_INLINE_MAX_RANGE) {
      return (
        <Panel flexDirection={'column'} gap={4}>
          <Text>{`${label}${desc}`}</Text>
          <Slider
            min={min}
            max={max}
            step={entry.step}
            value={numVal}
            onChange={(n): void => { setStaged(prev => ({ ...prev, [fullKey]: n })); }}
            title={label}
            submitLabel={'Set'}
          />
        </Panel>
      );
    }

    return (
      <Panel flexDirection={'column'} gap={4}>
        <Text>{`${label}${desc}`}</Text>
        <Input
          value={String(numVal)}
          onChange={(s): void => {
            const n = Number(s);
            if (Number.isFinite(n)) setStaged(prev => ({ ...prev, [fullKey]: n }));
          }}
          placeholder={'Enter number'}
          label={label}
          title={label}
          submitLabel={'Set'}
        />
      </Panel>
    );
  }

  if (entry.type === 'string') {
    return (
      <Panel flexDirection={'column'} gap={4}>
        <Text>{`${label}${desc}`}</Text>
        <Input
          value={typeof currentVal === 'string' ? currentVal : ''}
          onChange={(s): void => { setStaged(prev => ({ ...prev, [fullKey]: s })); }}
          placeholder={`Enter ${label.toLowerCase()}`}
          label={label}
          title={label}
          submitLabel={'Set'}
        />
      </Panel>
    );
  }

  if (entry.type === 'enum' && entry.options) {
    const options = [...entry.options];
    const currentStr = typeof currentVal === 'string' ? currentVal : options[0] ?? '';

    return (
      <Panel flexDirection={'column'} gap={4}>
        <Text>{`${label}${desc}`}</Text>
        <Dropdown
          options={options}
          value={currentStr}
          onChange={(v): void => { setStaged(prev => ({ ...prev, [fullKey]: v })); }}
          label={label}
          title={label}
          submitLabel={'Select'}
        />
      </Panel>
    );
  }

  if (entry.type === 'list') {
    const currentList = listStaged[fullKey] ?? [];

    return (
      <Panel flexDirection={'row'} alignItems={'center'} gap={spacing.xs}>
        <Text flexGrow={1}>{`${label}  (${String(currentList.length)} items)${desc}`}</Text>
        <Button
          onPress={(): void => {
            navigation.navigate('ConfigForm', {
              title: label,
              list: [...currentList],
              schema: { itemType: entry.itemType, options: entry.options, maxItems: entry.maxItems },
              onDone: (updated): void => {
                setListStaged(prev => ({ ...prev, [fullKey]: updated }));
                navigation.navigate('Config', routeParams);
              },
            });
          }}
        >
          {'Edit list'}
        </Button>
      </Panel>
    );
  }

  return <Fragment />;
}
