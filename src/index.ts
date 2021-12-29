import {
	JsonFragment,
	JsonFragmentType,
	ParamType,
	Result,
	defaultAbiCoder,
} from '@ethersproject/abi';
import { keccak256 } from '@ethersproject/keccak256';
import { toUtf8Bytes } from '@ethersproject/strings';

interface FunctionData {
	name: string;
	inputs: JsonFragmentType[];
	values: Result;
}

interface FunctionOutputData {
	name: string;
	outputs: JsonFragmentType[];
	values: Result;
}

interface Constructor {
	inputs: JsonFragmentType[];
	values: Result;
}

interface Event {
	name: string;
	inputs: JsonFragmentType[];
	values: Result;
}

interface EventEncoding {
	topics: string[];
	data: string;
}

class Coder {
	private abi: JsonFragment[];

	constructor(abi: JsonFragment[]) {
		this.abi = abi;
	}

	getFunctionSelector(name: string): string | undefined {
		const func = this.getFunctionByName(name);
		const jsonInputs = func?.inputs;
		if (!jsonInputs) {
			return;
		}
		const inputs = jsonInputs.map((input) => ParamType.fromObject(input));
		const signature = Coder.getSignature(name, inputs);
		const hash = sha3(signature);
		return hash.substring(0, 10);
	}

	getEventTopic(name: string): string | undefined {
		const event = this.getEventByName(name);
		const jsonInputs = event?.inputs;
		if (!jsonInputs) {
			return;
		}
		const inputs = jsonInputs.map((input) => ParamType.fromObject(input));
		const signature = Coder.getSignature(name, inputs);
		return sha3(signature);
	}

	decodeConstructor(data: string): Constructor | undefined {
		const constructor = this.getConstructor();
		const jsonInputs = constructor?.inputs;
		if (!jsonInputs) {
			return;
		}
		const inputs = jsonInputs.map((input) => ParamType.fromObject(input));
		const result = defaultAbiCoder.decode(inputs, data);
		return {
			inputs,
			values: result,
		};
	}

	decodeEvent(topics: string[], data: string): Event | undefined {
		const event = this.getEventByTopic(topics[0]);
		const [, ...dataTopics] = topics;
		const jsonInputs = event?.inputs;
		if (!jsonInputs) {
			return;
		}
		const inputs = jsonInputs.map((input) => ParamType.fromObject(input));
		// Decode topics
		const topicInputs = inputs.filter((input) => input.indexed);
		const topicResult = topicInputs.map((input, index) => {
			const topic = dataTopics[index];
			const params = defaultAbiCoder.decode([input], topic);
			const [param] = params;
			return param;
		});
		// Decode data
		const dataInputs = inputs.filter((input) => !input.indexed);
		const dataResult = defaultAbiCoder.decode(dataInputs, data);
		// Concat
		if (!event.name) {
			return;
		}
		let topicIndex = 0;
		let dataIndex = 0;
		const result: Result = [];
		for (const input of inputs) {
			if (input.indexed) {
				result.push(topicResult[topicIndex]);
				topicIndex++;
			} else {
				result.push(dataResult[dataIndex]);
				dataIndex++;
			}
		}
		return {
			name: event.name,
			inputs,
			values: result,
		};
	}

	decodeFunction(data: string): FunctionData | undefined {
		const selector = data.substring(0, 10);
		const func = this.getFunctionBySelector(selector);
		// Decode calldata using function inputs
		const jsonInputs = func?.inputs;
		if (!jsonInputs) {
			return;
		}
		const inputs = jsonInputs.map((input) => ParamType.fromObject(input));
		const calldata = `0x${data.substring(10)}`;
		const result = defaultAbiCoder.decode(inputs, calldata);

		if (!func.name) {
			return;
		}
		return {
			name: func.name,
			inputs,
			values: result,
		};
	}

	decodeFunctionOutput(
		name: string,
		data: string,
	): FunctionOutputData | undefined {
		const func = this.getFunctionByName(name);
		const jsonOutputs = func?.outputs;
		if (!jsonOutputs) {
			return;
		}
		const outputs = jsonOutputs.map((output) => ParamType.fromObject(output));
		const result = defaultAbiCoder.decode(outputs, data);
		return {
			name,
			outputs,
			values: result,
		};
	}

	encodeConstructor(constructorData: Constructor): string | undefined {
		const constructor = this.getConstructor();
		const jsonInputs = constructor?.inputs;
		if (!jsonInputs) {
			return;
		}
		const inputs = jsonInputs.map((input) => ParamType.fromObject(input));
		const result = constructorData.values;
		const data = defaultAbiCoder.encode(inputs, result);
		return `0x${data}`;
	}

	encodeEvent(eventData: Event): EventEncoding | undefined {
		const { name, values } = eventData;
		const event = this.getEventByName(name);
		const jsonInputs = event?.inputs;
		if (!jsonInputs) {
			return;
		}
		const inputs = jsonInputs.map((input) => ParamType.fromObject(input));
		const eventSignature = Coder.getSignature(name, inputs);
		const eventTopic = sha3(eventSignature);
		// Group params by type
		const topicResult: Result = [];
		const dataResult: Result = [];
		for (let i = 0; i < inputs.length; i++) {
			const input = inputs[i];
			const value = values[i];
			if (input.indexed) {
				topicResult.push(value);
			} else {
				dataResult.push(value);
			}
		}
		// Encode topic params
		const topicInputs = inputs.filter((input) => input.indexed);
		const dataTopics = topicInputs.map((input, index) => {
			return defaultAbiCoder.encode([input], [topicResult[index]]);
		});
		const topics = [eventTopic, ...dataTopics];
		// Encode data params
		const dataInputs = inputs.filter((input) => !input.indexed);
		const data = defaultAbiCoder.encode(dataInputs, dataResult);

		return {
			topics,
			data,
		};
	}

	encodeFunction(functionData: FunctionData): string | undefined {
		const { name, values } = functionData;
		const func = this.getFunctionByName(name);
		const jsonInputs = func?.inputs;
		if (!jsonInputs) {
			return;
		}
		const inputs = jsonInputs.map((input) => ParamType.fromObject(input));
		const signature = Coder.getSignature(name, inputs);
		const selector = sha3(signature).substring(2, 10);
		const argumentString = defaultAbiCoder.encode(inputs, values);
		const argumentData = argumentString.substring(2);
		const inputData = `0x${selector}${argumentData}`;
		return inputData;
	}

	encodeFunctionOutput(functionData: FunctionOutputData): string | undefined {
		const func = this.getFunctionByName(functionData.name);
		const jsonOutputs = func?.outputs;
		if (!jsonOutputs) {
			return;
		}
		const outputs = jsonOutputs.map((output) => ParamType.fromObject(output));
		const result = functionData.values;
		return defaultAbiCoder.encode(outputs, result);
	}

	private getConstructor(): JsonFragment | undefined {
		return this.abi.find((item) => item.type === 'constructor');
	}

	private getFunctionByName(name: string): JsonFragment | undefined {
		return this.abi.find(
			(item) => item.type === 'function' && item.name === name,
		);
	}

	private getFunctionBySelector(selector: string): JsonFragment | undefined {
		const functions = this.abi.filter((item) => item.type === 'function');
		const func = functions.find((func) => {
			const name = func.name;
			const jsonInputs = func.inputs;
			if (!name || !jsonInputs) {
				return false;
			}
			const inputs = jsonInputs.map((input) => ParamType.fromObject(input));
			const signature = Coder.getSignature(name, inputs);
			const hash = sha3(signature);
			const funcSelector = hash.substring(0, 10);
			return funcSelector === selector;
		});
		return func;
	}

	private getEventByName(name: string): JsonFragment | undefined {
		return this.abi.find((item) => item.type === 'event' && item.name === name);
	}

	private getEventByTopic(topic: string): JsonFragment | undefined {
		const events = this.abi.filter((item) => item.type === 'event');
		const event = events.find((event) => {
			const name = event.name;
			const jsonInputs = event.inputs;
			if (!name || !jsonInputs) {
				return false;
			}
			const inputs = jsonInputs.map((input) => ParamType.fromObject(input));
			const signature = Coder.getSignature(name, inputs);
			const eventTopic = sha3(signature);
			return eventTopic === topic;
		});
		return event;
	}

	private static getSignature(name: string, inputs: ParamType[]): string {
		const types: string[] = [];
		for (const input of inputs) {
			if (input.type === 'tuple') {
				const tupleString = Coder.getSignature('', input.components);
				types.push(tupleString);
				continue;
			}
			if (input.type === 'tuple[]') {
				const tupleString = Coder.getSignature('', input.components);
				const arrayString = `${tupleString}[]`;
				types.push(arrayString);
				continue;
			}
			types.push(input.type);
		}
		const typeString = types.join(',');
		const functionSignature = `${name}(${typeString})`;
		return functionSignature;
	}
}

function sha3(input: string) {
	return keccak256(toUtf8Bytes(input));
}

export default Coder;
