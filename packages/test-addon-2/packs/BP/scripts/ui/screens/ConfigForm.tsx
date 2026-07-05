import { Fragment, Panel, Scroll, Text, useState, type JSX } from '@bedrock-core/ui-runtime';
import { Button, Card, Divider, Dropdown, Input, theme } from '@bedrock-core/ore-styled';
import type { AppScreen } from '../routes';

const { spacing } = theme.tokens;

export function ConfigForm({ navigation, route }: AppScreen<'ConfigForm'>): JSX.Element {
  const { title, list: initialList, schema, onDone } = route.params;
  const [items, setItems] = useState<string[]>(initialList);
  const [draft, setDraft] = useState('');

  const canAdd = schema.maxItems === undefined || items.length < schema.maxItems;

  function addItem(value: string): void {
    if (!value || !canAdd) return;
    setItems(prev => [...prev, value]);
    setDraft('');
  }

  function removeItem(index: number): void {
    setItems(prev => prev.filter((_, i) => i !== index));
  }

  return (
    <Card flexDirection={'column'} padding={12} gap={spacing.sm}>
      <Text font={'minecraftTen'} scale={1.5}>{title}</Text>
      <Divider />
      <Scroll>
        <Panel flexDirection={'column'} gap={spacing.xs}>
          {items.length === 0
            ? <Text>{'No items.'}</Text>
            : items.map((item, index) => (
              <Panel flexDirection={'row'} alignItems={'center'} gap={spacing.xs}>
                <Text flexGrow={1}>{item}</Text>
                <Button variant={'contrast'} onPress={(): void => removeItem(index)}>{'X'}</Button>
              </Panel>
            ))
          }
        </Panel>
      </Scroll>
      {canAdd ? (
        <Fragment>
          <Divider variant={'light'} />
          {schema.options && schema.options.length > 0 ? (
            <Panel flexDirection={'row'} gap={spacing.xs}>
              <Panel flexGrow={1}>
                <Dropdown
                  options={[...schema.options]}
                  value={draft || (schema.options[0] ?? '')}
                  onChange={setDraft}
                  label={'Value'}
                  title={`Add ${title}`}
                  submitLabel={'Select'}
                />
              </Panel>
              <Button onPress={(): void => addItem(draft || (schema.options?.[0] ?? ''))}>{'Add'}</Button>
            </Panel>
          ) : (
            <Panel flexDirection={'row'} gap={spacing.xs}>
              <Panel flexGrow={1}>
                <Input
                  value={draft}
                  onChange={setDraft}
                  placeholder={`Add ${title.toLowerCase()}`}
                  label={'Value'}
                  title={`Add ${title}`}
                  submitLabel={'Add'}
                />
              </Panel>
              <Button onPress={(): void => addItem(draft)}>{'Add'}</Button>
            </Panel>
          )}
        </Fragment>
      ) : null}
      <Panel flexDirection={'row'} gap={spacing.xs}>
        <Button flexGrow={1} onPress={(): void => { onDone(items); navigation.goBack(); }}>{'Done'}</Button>
        <Button flexGrow={1} variant={'secondary'} onPress={(): void => navigation.goBack()}>{'Cancel'}</Button>
      </Panel>
    </Card>
  );
}
